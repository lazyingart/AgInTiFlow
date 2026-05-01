#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session-store.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-inbox-"));

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

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: ["session-inbox-append", "session-inbox-drain", "session-inbox-asap-priority"],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
