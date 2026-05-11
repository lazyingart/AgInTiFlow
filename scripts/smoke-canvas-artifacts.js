import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildArtifacts,
  normalizeCanvasPayload,
  persistCanvasPayloadFile,
  readArtifactContent,
  resolveArtifactFile,
} from "../src/artifact-tunnel.js";
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

  const largeImagePath = path.join(workspace, "large-preview.png");
  const pngHeader = Buffer.from("89504e470d0a1a0a", "hex");
  await fs.writeFile(largeImagePath, Buffer.concat([pngHeader, Buffer.alloc(4_200_000)]));
  const largeNormalized = normalizeCanvasPayload(
    {
      title: "Large preview image",
      kind: "image",
      path: "large-preview.png",
      selected: true,
    },
    config
  );
  if (!largeNormalized.ok) throw new Error(largeNormalized.reason || "large image canvas payload normalization failed");
  const largePersisted = await persistCanvasPayloadFile(largeNormalized.payload, { config, store });
  if (!largePersisted.ok) throw new Error(largePersisted.reason || "large image canvas artifact persistence failed");
  if (!largePersisted.payload.artifactPersisted) throw new Error("large image was not persisted into session artifacts");

  const largeEvents = [
    {
      timestamp: new Date().toISOString(),
      type: "canvas.item",
      data: {
        ...largePersisted.payload,
        commandCwd: workspace,
      },
    },
  ];
  const { items: largeItems } = buildArtifacts({ sessionId: store.sessionId, events: largeEvents, store });
  const largeContent = await readArtifactContent(largeItems[0], { store, config });
  if (!largeContent.ok) throw new Error(largeContent.error || "large artifact metadata could not be read");
  if (largeContent.dataUrl) throw new Error("large artifact should not be inlined as a data URL");
  if (!largeContent.url || !largeContent.downloadUrl || !largeContent.tooLargeForInline) {
    throw new Error("large artifact did not expose streamed preview URLs");
  }
  const largeFile = await resolveArtifactFile(largeItems[0], { store, config });
  if (!largeFile.ok || largeFile.size <= 4_000_000 || largeFile.mime !== "image/png") {
    throw new Error("large artifact file resolver returned invalid metadata");
  }

  const largePdfPath = path.join(workspace, "compiled-paper.pdf");
  await fs.writeFile(largePdfPath, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4_200_000)]));
  const pdfNormalized = normalizeCanvasPayload(
    {
      title: "Compiled paper",
      kind: "pdf",
      path: "compiled-paper.pdf",
      selected: true,
    },
    config
  );
  if (!pdfNormalized.ok) throw new Error(pdfNormalized.reason || "large PDF canvas payload normalization failed");
  const pdfPersisted = await persistCanvasPayloadFile(pdfNormalized.payload, { config, store });
  if (!pdfPersisted.ok) throw new Error(pdfPersisted.reason || "large PDF canvas artifact persistence failed");
  const { items: pdfItems } = buildArtifacts({
    sessionId: store.sessionId,
    events: [
      {
        timestamp: new Date().toISOString(),
        type: "canvas.item",
        data: {
          ...pdfPersisted.payload,
          commandCwd: workspace,
        },
      },
    ],
    store,
  });
  const pdfContent = await readArtifactContent(pdfItems[0], { store, config });
  if (!pdfContent.ok || pdfContent.kind !== "pdf" || pdfContent.mime !== "application/pdf") {
    throw new Error(`large PDF artifact did not expose PDF metadata: ${JSON.stringify(pdfContent)}`);
  }
  if (!pdfContent.tooLargeForInline || !pdfContent.url || !pdfContent.downloadUrl || pdfContent.dataUrl) {
    throw new Error("large PDF artifact should stream through preview/download URLs instead of inline data");
  }

  const missing = await persistCanvasPayloadFile({ ...normalized.payload, path: "missing.png" }, { config, store });
  if (missing.ok) throw new Error("missing canvas path should fail persistence");

  await fs.rm(root, { recursive: true, force: true });
  console.log("smoke-canvas-artifacts ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
