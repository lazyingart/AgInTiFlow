import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildArtifacts, normalizeCanvasPayload, persistCanvasPayloadFile, readArtifactContent } from "../src/artifact-tunnel.js";
import { SessionStore } from "../src/session-store.js";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-canvas-artifacts-"));
  const workspace = path.join(root, "workspace");
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(workspace, { recursive: true });

  const sourcePath = path.join(workspace, "durable-report.md");
  await fs.writeFile(sourcePath, "# Durable report\n\nThis file should survive canvas preview cleanup.\n", "utf8");

  const config = {
    commandCwd: workspace,
    allowFileTools: true,
  };
  const store = new SessionStore(sessionsDir, "canvas-smoke");
  await store.ensure();

  const normalized = normalizeCanvasPayload(
    {
      title: "Durable report",
      kind: "markdown",
      path: "durable-report.md",
      selected: true,
    },
    config
  );
  if (!normalized.ok) throw new Error(normalized.reason || "canvas payload normalization failed");

  const persisted = await persistCanvasPayloadFile(normalized.payload, { config, store });
  if (!persisted.ok) throw new Error(persisted.reason || "canvas artifact persistence failed");
  if (!persisted.payload.artifactPersisted) throw new Error("canvas file was not persisted into session artifacts");

  await fs.rm(sourcePath);

  const events = [
    {
      timestamp: new Date().toISOString(),
      type: "canvas.item",
      data: {
        ...persisted.payload,
        commandCwd: workspace,
      },
    },
  ];
  const { items } = buildArtifacts({ sessionId: store.sessionId, events, store });
  if (items.length !== 1) throw new Error(`expected one artifact, got ${items.length}`);

  const content = await readArtifactContent(items[0], { store, config });
  if (!content.ok) throw new Error(content.error || "persisted artifact could not be read");
  if (!String(content.text || "").includes("Durable report")) throw new Error("persisted artifact content mismatch");

  const missing = await persistCanvasPayloadFile({ ...normalized.payload, path: "missing.png" }, { config, store });
  if (missing.ok) throw new Error("missing canvas path should fail persistence");

  await fs.rm(root, { recursive: true, force: true });
  console.log("smoke-canvas-artifacts ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
