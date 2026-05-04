#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSkillPackFromMarkdown,
  enableSkillMeshSkill,
  installSkillPack,
  listInstalledSkillMeshSkills,
  loadSkillMeshConfig,
  setSkillMeshMode,
  startSkillMeshRelay,
  submitSkillPack,
  syncSkillMesh,
  validateSkillPack,
} from "../src/skillmesh.js";
import { listSkills, selectSkillsForGoal } from "../src/skill-library.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-skillmesh-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, "home");

const skillMarkdown = [
  "---",
  "id: mesh-android-screenshot",
  "label: Mesh Android Screenshot",
  "description: Capture Android emulator screenshots safely and save them in the current workspace.",
  "triggers:",
  "  - android screenshot",
  "  - emulator capture",
  "tools:",
  "  - shell",
  "---",
  "",
  "When asked to capture an Android emulator screenshot, inspect available devices, run `adb exec-out screencap -p`,",
  "save to a descriptive workspace path, then verify the PNG exists before reporting success.",
  "",
].join("\n");

const pack = await buildSkillPackFromMarkdown(skillMarkdown, { valueScore: 95 });
const validation = validateSkillPack(pack);
assert(validation.packHash === pack.packHash, "pack hash should validate");

const installedDisabled = await installSkillPack(pack, { enabled: false });
assert(installedDisabled.installedSkills.includes("mesh-android-screenshot"), "pack did not install skill");
assert(!listSkills({ includeBody: false }).some((skill) => skill.id === "mesh-android-screenshot"), "disabled mesh skill should not load");

await enableSkillMeshSkill("mesh-android-screenshot", true);
assert(listSkills({ includeBody: false }).some((skill) => skill.id === "mesh-android-screenshot"), "enabled mesh skill should load");
assert(
  selectSkillsForGoal("please take an android emulator screenshot", { limit: 6 }).some((skill) => skill.id === "mesh-android-screenshot"),
  "enabled mesh skill should be selectable"
);

const installed = await listInstalledSkillMeshSkills();
assert(installed.some((skill) => skill.id === "mesh-android-screenshot"), "installed mesh skill should list");

await setSkillMeshMode("off");
assert(!listSkills({ includeBody: false }).some((skill) => skill.id === "mesh-android-screenshot"), "off mode should suppress mesh skills");
await setSkillMeshMode("share");
const config = await loadSkillMeshConfig();
assert(config.mode === "share", "share mode should persist");

const secretMarkdown = skillMarkdown.replace("mesh-android-screenshot", "mesh-secret-test") + "\nOPENAI_API_KEY=sk-thisShouldBeRejected1234567890\n";
let rejected = false;
try {
  await buildSkillPackFromMarkdown(secretMarkdown);
} catch {
  rejected = true;
}
assert(rejected, "secret-like skill pack should be rejected");

const relay = await startSkillMeshRelay({ host: "127.0.0.1", port: 0, dataDir: path.join(tempRoot, "relay") });
try {
  const submit = await submitSkillPack(pack, relay.url);
  assert(submit.ok && submit.packHash === pack.packHash, "relay submit failed");
  const health = await fetch(`${relay.url}/health`).then((response) => response.json());
  assert(health.ok && health.acceptsRawSessions === false, "relay health should advertise safe contract");
  const feed = await fetch(`${relay.url}/feed.json`).then((response) => response.json());
  assert(feed.packs.some((item) => item.packHash === pack.packHash), "relay feed should include submitted pack");
  const nodes = await fetch(`${relay.url}/nodes.json`).then((response) => response.json());
  assert(Array.isArray(nodes.nodes), "relay should expose a node list");

  process.env.AGINTIFLOW_HOME = path.join(tempRoot, "client-home");
  const sync = await syncSkillMesh({ nodeUrl: relay.url, install: true });
  assert(sync.ok && sync.downloaded.length === 1, "client sync should download one pack");
  assert(!listSkills({ includeBody: false }).some((skill) => skill.id === "mesh-android-screenshot"), "synced community skill should install disabled");
} finally {
  await relay.close();
}

process.env.AGINTIFLOW_HOME = path.join(tempRoot, "unreachable-home");
const unreachable = await syncSkillMesh({ nodeUrl: "http://127.0.0.1:9" });
assert(unreachable.ok && unreachable.skipped && unreachable.unreachable, "unreachable sync should fail soft");

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "signed-pack",
        "secret-rejection",
        "install-disabled-by-default",
        "enable-mesh-skill",
        "relay-submit-feed",
        "relay-node-list",
        "metadata-sync",
        "soft-unreachable-node",
      ],
    },
    null,
    2
  )
);
