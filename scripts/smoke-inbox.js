#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  ensureProjectSessionStorage,
  listProjectSessionRemovalCandidates,
  listProjectSessions,
  removeProjectSessions,
  sessionStoreOptions,
} from "../src/project.js";
import { SessionStore } from "../src/session-store.js";
import { flushHousekeeping, readHousekeepingSummary } from "../src/housekeeping.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-inbox-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRejects(operation, message) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

async function readOptional(filePath) {
  return fs.readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
}

function jsonlRecordCount(raw) {
  return String(raw || "").split("\n").filter((line) => line.trim()).length;
}

async function simulateStaleClaim(store, itemId) {
  await fs.appendFile(
    store.inboxClaimsPath,
    `${JSON.stringify({
      key: `id:${itemId}`,
      consumerId: "simulated-dead-consumer",
      pid: process.pid,
      claimedAt: "2000-01-01T00:00:00.000Z",
    })}\n`,
    "utf8"
  );
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.stat(filePath).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for inbox worker barrier: ${filePath}`);
}

function startDrainWorker({ moduleUrl, baseDir, sessionId, readyPath, goPath, resultPath, releasePath }) {
  const source = `
    import fs from "node:fs/promises";
    import { SessionStore } from ${JSON.stringify(moduleUrl)};
    const [baseDir, sessionId, readyPath, goPath, resultPath, releasePath] = process.argv.slice(1);
    const store = new SessionStore(baseDir, sessionId);
    await fs.writeFile(readyPath, "ready\\n", "utf8");
    while (!(await fs.stat(goPath).then(() => true).catch(() => false))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const items = await store.drainInbox();
    await fs.writeFile(resultPath, JSON.stringify(items.map((item) => item.id)) + "\\n", "utf8");
    while (!(await fs.stat(releasePath).then(() => true).catch(() => false))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    process.stdout.write(JSON.stringify(items.map((item) => item.id)) + "\\n");
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, baseDir, sessionId, readyPath, goPath, resultPath, releasePath],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Inbox drain worker exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`Inbox drain worker returned invalid JSON: ${stdout.trim()} (${error.message})`));
      }
    });
  });
  return { child, completion };
}

try {
  const store = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-smoke");
  const first = await store.appendInbox("first queued message", { source: "test" });
  await store.appendInbox("second queued message", { source: "test" });
  await store.appendInbox("urgent piped message", { source: "test", priority: "asap" });

  assert(first?.id, "appendInbox did not return an inbox id");

  const drained = await store.drainInbox();
  assert(drained.length === 3, "inbox did not drain all messages");
  assert(drained[0].content === "urgent piped message", "asap message was not drained first");
  assert(drained[1].content === "first queued message", "first queued message mismatch");
  assert(drained[2].content === "second queued message", "second queued message mismatch");
  assert((await store.drainInbox()).length === 0, "inbox was not cleared after drain");

  const liveClaimBase = path.join(tempRoot, ".sessions");
  const liveClaimSession = "inbox-live-claim-smoke";
  const liveClaimStore = new SessionStore(liveClaimBase, liveClaimSession);
  await liveClaimStore.appendInbox("single-consumer delivery", { id: "live-claim-item", source: "test" });
  const barrierDir = path.join(tempRoot, "inbox-worker-barrier");
  await fs.mkdir(barrierDir, { recursive: true });
  const goPath = path.join(barrierDir, "go");
  const releasePath = path.join(barrierDir, "release");
  const resultAPath = path.join(barrierDir, "result-a.json");
  const resultBPath = path.join(barrierDir, "result-b.json");
  const moduleUrl = new URL("../src/session-store.js", import.meta.url).href;
  const workerA = startDrainWorker({
    moduleUrl,
    baseDir: liveClaimBase,
    sessionId: liveClaimSession,
    readyPath: path.join(barrierDir, "ready-a"),
    goPath,
    resultPath: resultAPath,
    releasePath,
  });
  const workerB = startDrainWorker({
    moduleUrl,
    baseDir: liveClaimBase,
    sessionId: liveClaimSession,
    readyPath: path.join(barrierDir, "ready-b"),
    goPath,
    resultPath: resultBPath,
    releasePath,
  });
  await Promise.all([waitForFile(path.join(barrierDir, "ready-a")), waitForFile(path.join(barrierDir, "ready-b"))]);
  await fs.writeFile(goPath, "go\n", "utf8");
  await Promise.all([waitForFile(resultAPath), waitForFile(resultBPath)]);
  const concurrentDrains = await Promise.all([
    fs.readFile(resultAPath, "utf8").then(JSON.parse),
    fs.readFile(resultBPath, "utf8").then(JSON.parse),
  ]);
  await fs.writeFile(releasePath, "release\n", "utf8");
  await Promise.all([workerA.completion, workerB.completion]);
  assert(
    concurrentDrains.reduce((total, items) => total + items.length, 0) === 1,
    "two live SessionStore processes delivered the same claimed inbox item"
  );
  const staleClaimRecovery = new SessionStore(liveClaimBase, liveClaimSession);
  const [staleClaimItem] = await staleClaimRecovery.drainInbox();
  assert(staleClaimItem?.id === "live-claim-item", "a dead/stale inbox claim was not replayed");
  staleClaimRecovery.markInboxApplied(staleClaimItem);
  await staleClaimRecovery.saveState({
    sessionId: "inbox-live-claim-smoke",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    provider: "mock",
    model: "mock-agent",
    chat: [{ role: "user", content: staleClaimItem.content }],
  });

  const rewriteClaimBase = path.join(tempRoot, ".sessions");
  const rewriteClaimSession = "inbox-live-claim-rewrite-smoke";
  const rewriteClaimOwner = new SessionStore(rewriteClaimBase, rewriteClaimSession);
  await rewriteClaimOwner.appendInbox("keep this claim live", { id: "rewrite-live-claim", source: "test" });
  const [rewriteClaimedItem] = await rewriteClaimOwner.drainInbox();
  assert(rewriteClaimedItem?.id === "rewrite-live-claim", "rewrite claim owner did not receive its item");
  const rewriteEditor = new SessionStore(rewriteClaimBase, rewriteClaimSession);
  await rewriteEditor.appendInbox("separate editable item", { id: "rewrite-editable", source: "test" });
  await rewriteEditor.mutateInbox((items) =>
    items.map((item) => (item.id === "rewrite-editable" ? { ...item, content: "edited during live claim" } : item))
  );
  const rewriteCompactor = new SessionStore(rewriteClaimBase, rewriteClaimSession, {
    inboxCompactionRecordThreshold: 1,
  });
  const rewriteDrain = await rewriteCompactor.drainInbox();
  assert(
    rewriteDrain.length === 1 && rewriteDrain[0].id === "rewrite-editable",
    "a queue rewrite exposed another consumer's live claim"
  );
  rewriteCompactor.markInboxApplied(rewriteDrain[0]);
  await rewriteCompactor.saveState({
    sessionId: rewriteClaimSession,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    provider: "mock",
    model: "mock-agent",
    chat: [{ role: "user", content: rewriteDrain[0].content }],
  });
  const rewriteObserver = new SessionStore(rewriteClaimBase, rewriteClaimSession);
  assert((await rewriteObserver.drainInbox()).length === 0, "compaction dropped live claim ownership metadata");
  const rewrittenClaims = (await readOptional(rewriteClaimOwner.inboxClaimsPath))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const preservedClaim = rewrittenClaims.find((claim) => claim.key === "id:rewrite-live-claim" && !claim.released);
  assert(
    preservedClaim?.consumerId === rewriteClaimOwner.inboxConsumerId && preservedClaim?.pid === process.pid,
    "queue rewrite did not preserve bounded live-claim owner metadata"
  );
  await rewriteClaimOwner.releaseInboxClaims();

  const crashSafeStore = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-crash-safe-smoke");
  const crashSafeItem = await crashSafeStore.appendInbox("survive drain before state save", {
    id: "inbox-crash-window",
    source: "test",
  });
  const beforeCrash = await crashSafeStore.drainInbox();
  assert(beforeCrash.length === 1 && beforeCrash[0].id === crashSafeItem.id, "crash-window inbox item was not delivered");
  assert((await crashSafeStore.drainInbox()).length === 0, "same process delivered an unacknowledged inbox item twice");
  await simulateStaleClaim(crashSafeStore, crashSafeItem.id);

  const recoveredStore = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-crash-safe-smoke");
  const recovered = await recoveredStore.drainInbox();
  assert(
    recovered.length === 1 && recovered[0].id === crashSafeItem.id,
    "a simulated crash before state persistence lost the drained inbox item"
  );
  recoveredStore.markInboxApplied(recovered[0]);
  await recoveredStore.saveState({
    sessionId: "inbox-crash-safe-smoke",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    provider: "mock",
    model: "mock-agent",
    goal: "inbox crash durability smoke",
    chat: [{ role: "user", content: recovered[0].content }],
  });
  const committedStore = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-crash-safe-smoke");
  assert((await committedStore.drainInbox()).length === 0, "state-persisted inbox item was delivered again");

  const partialBatchStore = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-partial-batch-smoke");
  await partialBatchStore.appendInbox("first batch item", { id: "batch-first", source: "test" });
  await partialBatchStore.appendInbox("second batch item", { id: "batch-second", source: "test" });
  const partialBatch = await partialBatchStore.drainInbox();
  const appliedFirst = partialBatch.find((item) => item.id === "batch-first");
  assert(appliedFirst, "partial batch did not contain its first item");
  partialBatchStore.markInboxApplied(appliedFirst);
  await partialBatchStore.saveState({
    sessionId: "inbox-partial-batch-smoke",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    provider: "mock",
    model: "mock-agent",
    goal: "partial inbox batch smoke",
    chat: [{ role: "user", content: appliedFirst.content }],
  });
  const partialBatchRecovery = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-partial-batch-smoke");
  const partialReplay = await partialBatchRecovery.drainInbox();
  assert(
    partialReplay.length === 1 && partialReplay[0].id === "batch-second",
    "saving after a mid-batch failure acknowledged an inbox item that was never incorporated"
  );
  partialBatchRecovery.markInboxApplied(partialReplay[0]);
  await partialBatchRecovery.saveState({
    sessionId: "inbox-partial-batch-smoke",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
    provider: "mock",
    model: "mock-agent",
    goal: "partial inbox batch smoke",
    chat: [
      { role: "user", content: appliedFirst.content },
      { role: "user", content: partialReplay[0].content },
    ],
  });

  const staleEditor = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-stale-edit-smoke");
  const staleWriter = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-stale-edit-smoke");
  await staleEditor.appendInbox("original editable item", { id: "editable-item", source: "test" });
  const staleSnapshot = await staleEditor.loadInbox();
  await staleWriter.appendInbox("late concurrent append", { id: "late-append", source: "test" });
  staleSnapshot[0] = { ...staleSnapshot[0], content: "edited item" };
  await staleEditor.saveInbox(staleSnapshot);
  const staleEditResult = await new SessionStore(
    path.join(tempRoot, ".sessions"),
    "inbox-stale-edit-smoke"
  ).loadInbox();
  assert(staleEditResult.find((item) => item.id === "editable-item")?.content === "edited item", "stale edit was not applied");
  assert(staleEditResult.some((item) => item.id === "late-append"), "stale edit replacement lost a concurrent append");

  const tornTailStore = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-torn-tail-smoke");
  await tornTailStore.ensure();
  await fs.writeFile(
    tornTailStore.inboxPath,
    `${JSON.stringify({ id: "tail-valid-1", content: "first valid item" })}\n${JSON.stringify({
      id: "tail-valid-2",
      content: "second valid item",
    })}\n{\"id\":\"torn-tail\"`,
    "utf8"
  );
  const tailRecovered = await tornTailStore.loadInbox();
  assert(tailRecovered.length === 2, "an incomplete final JSONL record hid earlier valid inbox items");
  await tornTailStore.appendInbox("append after torn tail", { id: "tail-valid-3", source: "test" });
  const repairedTailRaw = await fs.readFile(tornTailStore.inboxPath, "utf8");
  for (const line of repairedTailRaw.split("\n").filter((candidate) => candidate.trim())) JSON.parse(line);
  assert((await tornTailStore.loadInbox()).length === 3, "appending after a torn JSONL tail did not repair the queue");

  const corruptAckStore = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-corrupt-ack-smoke");
  await corruptAckStore.appendInbox("visible despite unrelated ack", { id: "ack-visible", source: "test" });
  await fs.writeFile(
    corruptAckStore.inboxAcknowledgementsPath,
    `${JSON.stringify({ key: "id:unrelated", acknowledgedAt: "2026-01-01T00:00:00.000Z" })}\nnot-json\n`,
    "utf8"
  );
  await assertRejects(
    () => corruptAckStore.loadInbox(),
    "an interior acknowledgement JSONL corruption was silently ignored"
  );

  const tornAckStore = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-torn-ack-smoke");
  await tornAckStore.appendInbox("recover around torn acknowledgement", { id: "torn-ack-item", source: "test" });
  await fs.writeFile(
    tornAckStore.inboxAcknowledgementsPath,
    `${JSON.stringify({ key: "id:unrelated", acknowledgedAt: "2026-01-01T00:00:00.000Z" })}\n{\"key\":`,
    "utf8"
  );
  const [tornAckItem] = await tornAckStore.drainInbox();
  assert(tornAckItem?.id === "torn-ack-item", "an incomplete final acknowledgement hid an active inbox item");
  tornAckStore.markInboxApplied(tornAckItem);
  await tornAckStore.saveState({
    sessionId: "inbox-torn-ack-smoke",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    provider: "mock",
    model: "mock-agent",
    chat: [{ role: "user", content: tornAckItem.content }],
  });
  for (const line of (await readOptional(tornAckStore.inboxAcknowledgementsPath)).split("\n").filter((candidate) => candidate.trim())) {
    JSON.parse(line);
  }

  const compactingStore = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-compaction-smoke", {
    inboxCompactionRecordThreshold: 3,
    inboxCompactionByteThreshold: 4096,
  });
  for (let index = 0; index < 20; index += 1) {
    await compactingStore.appendInbox(`processed-${index}`, { id: `processed-${index}`, source: "test" });
    const [processed] = await compactingStore.drainInbox();
    compactingStore.markInboxApplied(processed);
    await compactingStore.saveState({
      sessionId: "inbox-compaction-smoke",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      provider: "mock",
      model: "mock-agent",
      chat: [{ role: "user", content: processed.content }],
    });
  }
  await compactingStore.appendInbox("final processed item", { id: "final-processed", source: "test" });
  const [finalProcessed] = await compactingStore.drainInbox();
  compactingStore.markInboxApplied(finalProcessed);
  const compactionWriter = new SessionStore(path.join(tempRoot, ".sessions"), "inbox-compaction-smoke");
  await Promise.all([
    compactingStore.saveState({
      sessionId: "inbox-compaction-smoke",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      provider: "mock",
      model: "mock-agent",
      chat: [{ role: "user", content: finalProcessed.content }],
    }),
    compactionWriter.appendInbox("late append racing compaction", { id: "compaction-late", source: "test" }),
  ]);
  const afterCompaction = await new SessionStore(
    path.join(tempRoot, ".sessions"),
    "inbox-compaction-smoke"
  ).loadInbox();
  assert(
    afterCompaction.length === 1 && afterCompaction[0].id === "compaction-late",
    "compaction lost or hid an append racing the acknowledgement"
  );
  const compactedRaw = await Promise.all([
    readOptional(compactingStore.inboxPath),
    readOptional(compactingStore.inboxClaimsPath),
    readOptional(compactingStore.inboxAcknowledgementsPath),
  ]);
  assert(
    compactedRaw.reduce((total, raw) => total + jsonlRecordCount(raw), 0) < 3,
    "processed inbox queue/claim/ack journals grew past the configured compaction bound"
  );

  const atomicProject = path.join(tempRoot, "atomic-project");
  const atomicPointers = path.join(atomicProject, ".aginti-sessions");
  const atomicStore = new SessionStore(path.join(tempRoot, ".sessions"), "atomic-session-smoke", {
    projectRoot: atomicProject,
    commandCwd: atomicProject,
    projectSessionsDir: atomicPointers,
  });
  await atomicStore.ensure();
  await fs.writeFile(atomicStore.statePath, "{\"old\":true}\n", { mode: 0o640 });
  await fs.chmod(atomicStore.statePath, 0o640);
  await fs.chmod(atomicStore.pointerPath, 0o600);
  await atomicStore.saveState({
    sessionId: "atomic-session-smoke",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
    provider: "mock",
    model: "mock-agent",
    goal: "atomic state smoke",
    projectRoot: atomicProject,
    commandCwd: atomicProject,
    chat: [],
  });
  assert(((await fs.stat(atomicStore.statePath)).mode & 0o7777) === 0o640, "atomic state replacement changed file permissions");
  assert(((await fs.stat(atomicStore.pointerPath)).mode & 0o7777) === 0o600, "atomic pointer replacement changed file permissions");
  assert(JSON.parse(await fs.readFile(atomicStore.statePath, "utf8")).goal === "atomic state smoke", "atomic state was unreadable");
  assert(
    JSON.parse(await fs.readFile(atomicStore.pointerPath, "utf8")).goal === "atomic state smoke",
    "atomic pointer was unreadable"
  );
  const leftoverTemps = (await fs.readdir(atomicStore.sessionDir)).filter((name) => name.endsWith(".tmp"));
  const leftoverPointerTemps = (await fs.readdir(atomicStore.pointerDir)).filter((name) => name.endsWith(".tmp"));
  assert(leftoverTemps.length === 0 && leftoverPointerTemps.length === 0, "atomic replacement left temporary files behind");

  const legacyProject = path.join(tempRoot, "legacy-project");
  const legacySession = "legacy-session-smoke";
  const legacyDir = path.join(legacyProject, ".sessions", legacySession);
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(
    path.join(legacyDir, "state.json"),
    `${JSON.stringify({
      sessionId: legacySession,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      provider: "mock",
      model: "mock-agent",
      goal: "legacy migration smoke",
      commandCwd: legacyProject,
      chat: [],
    })}\n`,
    "utf8"
  );
  await fs.writeFile(path.join(legacyDir, "events.jsonl"), "", "utf8");
  const gitInit = spawnSync("git", ["init"], {
    cwd: legacyProject,
    encoding: "utf8",
  });
  assert(gitInit.status === 0, `legacy storage Git init failed: ${gitInit.stderr || gitInit.stdout}`);
  const paths = await ensureProjectSessionStorage(legacyProject);
  const gitignore = await readOptional(path.join(legacyProject, ".gitignore"));
  const localExclude = await fs.readFile(path.join(legacyProject, ".git", "info", "exclude"), "utf8");
  assert(gitignore === "", "runtime session setup dirtied the tracked .gitignore");
  assert(
    localExclude.includes(".aginti-sessions/") &&
      localExclude.includes(".sessions/") &&
      localExclude.includes(".aginti/codebase-map.json"),
    "runtime session/cache paths were not protected by the repository-local Git exclude"
  );
  const migrated = await listProjectSessions(legacyProject, 10);
  assert(migrated.some((session) => session.sessionId === legacySession), "legacy session was not discoverable after migration");
  assert(
    await fs.stat(path.join(paths.globalSessionsDir, legacySession, "state.json")).then((stat) => stat.isFile()).catch(() => false),
    "legacy session state was not copied to the global store"
  );
  assert(
    await fs.stat(path.join(paths.sessionsDir, legacySession, "session.json")).then((stat) => stat.isFile()).catch(() => false),
    "project session pointer was not created"
  );

  const nestedCwd = path.join(legacyProject, "nested");
  await fs.mkdir(nestedCwd, { recursive: true });
  const otherCwdStore = new SessionStore(paths.globalSessionsDir, "other-cwd-smoke", sessionStoreOptions(legacyProject, "other-cwd-smoke"));
  await otherCwdStore.saveState({
    sessionId: "other-cwd-smoke",
    createdAt: "2026-01-01T00:02:00.000Z",
    updatedAt: "2026-01-01T00:03:00.000Z",
    provider: "mock",
    model: "mock-agent",
    goal: "nested cwd smoke",
    projectRoot: legacyProject,
    commandCwd: nestedCwd,
    chat: [],
  });
  const cwdFiltered = await listProjectSessions(legacyProject, { limit: 10, commandCwd: legacyProject });
  assert(!cwdFiltered.some((session) => session.sessionId === "other-cwd-smoke"), "default cwd filtering included a different cwd session");
  const allSessions = await listProjectSessions(legacyProject, { limit: 10, allSessions: true });
  assert(allSessions.some((session) => session.sessionId === "other-cwd-smoke"), "--all-sessions mode did not include a different cwd session");

  const emptyStore = new SessionStore(paths.globalSessionsDir, "empty-session-smoke", sessionStoreOptions(legacyProject, "empty-session-smoke"));
  await emptyStore.saveState({
    sessionId: "empty-session-smoke",
    createdAt: "2026-01-01T00:04:00.000Z",
    updatedAt: "2026-01-01T00:04:00.000Z",
    provider: "mock",
    model: "mock-agent",
    projectRoot: legacyProject,
    commandCwd: legacyProject,
    chat: [],
    stepsCompleted: 0,
  });
  const nonEmptyStore = new SessionStore(paths.globalSessionsDir, "nonempty-session-smoke", sessionStoreOptions(legacyProject, "nonempty-session-smoke"));
  await nonEmptyStore.saveState({
    sessionId: "nonempty-session-smoke",
    createdAt: "2026-01-01T00:05:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    provider: "mock",
    model: "mock-agent",
    goal: "keep this non-empty session",
    projectRoot: legacyProject,
    commandCwd: legacyProject,
    chat: [{ role: "user", content: "hello" }],
    stepsCompleted: 1,
  });
  const removalCandidates = await listProjectSessionRemovalCandidates(legacyProject, { limit: 20, commandCwd: legacyProject });
  assert(removalCandidates.find((session) => session.sessionId === "empty-session-smoke")?.isEmpty, "empty session was not detected");
  assert(removalCandidates.find((session) => session.sessionId === "nonempty-session-smoke")?.isEmpty === false, "non-empty session was classified as empty");
  const emptyOnly = await listProjectSessionRemovalCandidates(legacyProject, { limit: 20, commandCwd: legacyProject, emptyOnly: true });
  assert(emptyOnly.some((session) => session.sessionId === "empty-session-smoke"), "empty-only removal list omitted the empty session");
  assert(!emptyOnly.some((session) => session.sessionId === "nonempty-session-smoke"), "empty-only removal list included a non-empty session");
  const removed = await removeProjectSessions(legacyProject, ["empty-session-smoke"]);
  assert(removed.removed.length === 1, "empty session removal did not report one removed session");
  assert(
    !(await fs.stat(path.join(paths.globalSessionsDir, "empty-session-smoke", "state.json")).then((stat) => stat.isFile()).catch(() => false)),
    "empty session global state was not removed"
  );
  assert(
    !(await fs.stat(path.join(paths.sessionsDir, "empty-session-smoke", "session.json")).then((stat) => stat.isFile()).catch(() => false)),
    "empty session project pointer was not removed"
  );

  const housekeepingStore = new SessionStore(paths.globalSessionsDir, "housekeeping-smoke", sessionStoreOptions(legacyProject, "housekeeping-smoke"));
  await housekeepingStore.appendEvent("skills.selected", {
    taskProfile: "website",
    skills: ["website-app", "code-review"],
    goal: "build a small website with token=secret-value",
  });
  await housekeepingStore.appendEvent("model.responded", {
    step: 1,
    content: "Use the local project at /tmp/private-project and avoid api_key=abc123456789.",
    toolCalls: [{ id: "call-secret", name: "run_command", arguments: "{\"command\":\"echo hi\"}" }],
  });
  await housekeepingStore.appendEvent("tool.started", {
    toolName: "run_command",
    args: { command: "echo token=secret-value" },
  });
  await flushHousekeeping();
  const housekeeping = await readHousekeepingSummary();
  assert(housekeeping.capabilities?.totals?.skillSelections >= 1, "housekeeping did not aggregate selected skills");
  assert(housekeeping.capabilities?.tools?.run_command?.count >= 1, "housekeeping did not aggregate tool usage");
  const housekeepingEvents = await fs.readFile(housekeeping.paths.eventsPath, "utf8");
  assert(!housekeepingEvents.includes("secret-value") && !housekeepingEvents.includes("abc123456789"), "housekeeping leaked raw secret text");

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "session-inbox-append",
          "session-inbox-drain",
          "session-inbox-asap-priority",
          "session-inbox-single-live-consumer",
          "session-inbox-stale-claim-replay",
          "session-inbox-live-claim-survives-rewrite-compaction",
          "session-inbox-crash-replay-before-state-save",
          "session-inbox-acknowledged-after-state-save",
          "session-inbox-mid-batch-replay",
          "session-inbox-stale-edit-preserves-late-append",
          "session-inbox-torn-final-record-recovery",
          "session-inbox-torn-acknowledgement-recovery",
          "session-inbox-interior-corruption-rejected",
          "session-inbox-bounded-journal-compaction",
          "session-inbox-compaction-preserves-racing-append",
          "atomic-state-pointer-write",
          "atomic-write-permission-preservation",
          "legacy-session-migration",
          "global-session-store",
          "cwd-session-filter",
          "all-sessions-list",
          "empty-session-detection",
          "empty-session-removal",
          "session-gitignore-protection",
          "housekeeping-redacted-learning-log",
        ],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
