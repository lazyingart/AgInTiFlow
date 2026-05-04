#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  const paths = await ensureProjectSessionStorage(legacyProject);
  const gitignore = await fs.readFile(path.join(legacyProject, ".gitignore"), "utf8");
  assert(gitignore.includes(".aginti-sessions/") && gitignore.includes(".sessions/"), "session folders were not protected by .gitignore");
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
