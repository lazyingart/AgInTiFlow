#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureProjectSessionStorage, listProjectSessions } from "../src/project.js";
import { SessionStore } from "../src/session-store.js";

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
        ],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
