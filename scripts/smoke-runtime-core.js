#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-runtime-core-"));
const originalHome = process.env.AGINTIFLOW_HOME;
const originalHousekeeping = process.env.AGINTIFLOW_HOUSEKEEPING;
process.env.AGINTIFLOW_HOUSEKEEPING = "0";

const {
  closeSessionIndexConnections,
  listSessionIndex,
  sessionIndexConnectionCount,
  upsertSessionIndex,
} = await import("../src/session-index.js");
const { SessionStore } = await import("../src/session-store.js");

try {
  const firstHome = path.join(tempRoot, "home-one");
  const firstProject = path.join(tempRoot, "project-one");
  process.env.AGINTIFLOW_HOME = firstHome;

  const indexStartedAt = performance.now();
  for (let index = 0; index < 200; index += 1) {
    assert.equal(
      upsertSessionIndex({
        sessionId: `runtime-${index}`,
        projectRoot: firstProject,
        commandCwd: firstProject,
        status: "running",
        goal: `runtime smoke ${index}`,
      }),
      true
    );
  }
  const indexElapsedMs = performance.now() - indexStartedAt;
  assert.equal(sessionIndexConnectionCount(), 1, "one runtime home should reuse one SQLite connection");
  const firstRows = listSessionIndex({ projectRoot: firstProject, commandCwd: firstProject, limit: 500 });
  assert.equal(firstRows.length, 200, "cached prepared queries lost indexed sessions");

  const secondHome = path.join(tempRoot, "home-two");
  const secondProject = path.join(tempRoot, "project-two");
  process.env.AGINTIFLOW_HOME = secondHome;
  assert.equal(
    upsertSessionIndex({
      sessionId: "other-home",
      projectRoot: secondProject,
      commandCwd: secondProject,
      status: "saved",
    }),
    true
  );
  assert.equal(sessionIndexConnectionCount(), 2, "separate runtime homes must not share a SQLite connection");
  assert.equal(listSessionIndex({ projectRoot: secondProject }).length, 1);
  assert.equal(listSessionIndex({ projectRoot: firstProject }).length, 0, "runtime homes leaked index records");

  process.env.AGINTIFLOW_HOME = firstHome;
  const store = new SessionStore(path.join(firstHome, "sessions"), "event-order");
  const eventStartedAt = performance.now();
  await Promise.all(
    Array.from({ length: 100 }, (_, index) => store.appendEvent("runtime.smoke", { index }))
  );
  const eventElapsedMs = performance.now() - eventStartedAt;
  const events = await store.loadEvents();
  assert.equal(events.length, 100, "concurrent appends lost or duplicated session events");
  assert.deepEqual(
    events.map((event) => event.data.index),
    Array.from({ length: 100 }, (_, index) => index),
    "concurrent session events were persisted out of order"
  );

  const missingStore = new SessionStore(path.join(firstHome, "sessions"), "missing-state");
  assert.equal(await missingStore.loadState(), null, "an absent session state should remain resumably absent");

  const corruptStore = new SessionStore(path.join(firstHome, "sessions"), "corrupt-state");
  await fs.mkdir(corruptStore.sessionDir, { recursive: true });
  await fs.writeFile(corruptStore.statePath, "{not-json\n", "utf8");
  await assert.rejects(
    corruptStore.loadState(),
    (error) => error?.code === "SESSION_STATE_CORRUPT" && error?.name === "SessionStateCorruptionError",
    "malformed session state must fail visibly instead of appearing missing"
  );

  closeSessionIndexConnections();
  assert.equal(sessionIndexConnectionCount(), 0, "session index connections did not close cleanly");
  console.log(
    `runtime core smoke passed (200 index writes ${indexElapsedMs.toFixed(1)}ms; 100 ordered events ${eventElapsedMs.toFixed(1)}ms)`
  );
} finally {
  closeSessionIndexConnections();
  if (originalHome === undefined) delete process.env.AGINTIFLOW_HOME;
  else process.env.AGINTIFLOW_HOME = originalHome;
  if (originalHousekeeping === undefined) delete process.env.AGINTIFLOW_HOUSEKEEPING;
  else process.env.AGINTIFLOW_HOUSEKEEPING = originalHousekeeping;
  await fs.rm(tempRoot, { recursive: true, force: true });
}
