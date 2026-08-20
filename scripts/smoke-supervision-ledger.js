#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "supervision-ledger.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-supervision-ledger-"));
const db = path.join(root, "campaign.sqlite");
const common = ["--db", db, "--campaign", "smoke"];

function run(command, args = []) {
  return JSON.parse(execFileSync(process.execPath, [script, command, ...common, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

run("init", ["--objective", "Exercise a resumable capability campaign", "--aginti-version", "0.0.0-smoke"]);
run("capability", [
  "--id", "media-chain", "--domain", "media", "--subdomain", "music-video-publish",
  "--description", "Reuse established music, video, and publication routines", "--priority", "90",
]);
run("scenario", [
  "--id", "media-dry-run", "--domain", "media", "--profile", "auto",
  "--prompt-quality", "normal", "--prompt", "Prepare the media chain without publishing.",
  "--expected-outputs", "[\"readiness.md\"]", "--validation", "Verify routine paths and no external write.",
]);
run("test", [
  "--id", "media-dry-run-001", "--capability", "media-chain", "--scenario", "media-dry-run",
  "--title", "Read-only established media routine probe", "--prompt-path", "TASK.md",
  "--expected-outputs", "[\"readiness.md\"]", "--validation", "Check artifact bytes and event evidence.",
]);
run("start", [
  "--id", "media-dry-run-001", "--aginti-version", "0.0.0-smoke",
  "--session", "session-smoke", "--tmux", "tmux-smoke",
]);
run("event", [
  "--id", "media-dry-run-001", "--kind", "artifact_verified",
  "--detail", "readiness.md exists and is non-empty", "--evidence", "readiness.md",
]);
run("fix", [
  "--id", "media-dry-run-001", "--repo", "AgInTiFlow", "--commit", "abc123",
  "--release", "0.0.1", "--summary", "Improved reusable skill discovery",
  "--files", "[\"src/skill-library.js\"]", "--validation", "[\"npm test\"]",
]);
run("finish", [
  "--id", "media-dry-run-001", "--status", "passed_after_fix",
  "--summary", "The routine was selected and externally verified.", "--evidence", "[\"readiness.md\"]",
]);
const status = run("status");
assert(status.ok, "ledger status did not succeed");
assert(fs.statSync(db).size > 0, "ledger database is empty");
assert(status.campaign?.id === "smoke", "campaign row was not preserved");
assert(status.capability_counts.some((row) => row.status === "passed_after_fix" && row.count === 1), "capability status was not updated");
assert(status.scenario_counts.some((row) => row.status === "backlog" && row.count === 1), "scenario was not recorded");
assert(status.test_counts.some((row) => row.status === "passed_after_fix" && row.count === 1), "test result was not recorded");
assert(status.recent_tests[0]?.session_id === "session-smoke", "session evidence was not retained");

fs.rmSync(root, { recursive: true, force: true });
console.log("supervision ledger smoke passed");
