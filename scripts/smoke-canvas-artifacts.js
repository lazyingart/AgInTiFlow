import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildArtifacts,
  normalizeCanvasPayload,
  persistCanvasPayloadFile,
  readArtifactContent,
  resolveArtifactFile,
} from "../src/artifact-tunnel.js";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assistant(content, toolCalls = []) {
  return {
    choices: [{ message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
  };
}

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

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
  if (persisted.payload.downloadName !== "durable-report.md") {
    throw new Error(`canvas artifact lost its meaningful download name: ${persisted.payload.downloadName}`);
  }
  if (!/^durable-report--[A-Za-z0-9_-]{8}\.md$/.test(path.basename(persisted.payload.sessionFilePath))) {
    throw new Error(`canvas persistence put an opaque id before the filename: ${persisted.payload.sessionFilePath}`);
  }

  const scriptedResponses = [
    assistant("Reading the existing report before delivery.", [
      toolCall("canvas-read", "read_file", {
        path: "durable-report.md",
        lineLimit: 80,
      }),
    ]),
    assistant("Sending the report.", [
      toolCall("canvas-initial", "send_to_canvas", {
        title: "Durable report",
        kind: "markdown",
        path: "durable-report.md",
        selected: true,
      }),
    ]),
    assistant("Trying the same unchanged report with a cosmetic title change.", [
      toolCall("canvas-duplicate", "send_to_canvas", {
        title: "Durable report final",
        kind: "markdown",
        path: "durable-report.md",
        selected: true,
      }),
    ]),
    assistant("Sending the report after its content changed between turns.", [
      toolCall("canvas-revised", "send_to_canvas", {
        title: "Durable report revised",
        kind: "markdown",
        path: "durable-report.md",
        selected: true,
      }),
    ]),
    assistant("", [
      toolCall("canvas-finish", "finish", {
        result: "Sent the initial report once and its revised content once.",
      }),
    ]),
  ];
  const modelCalls = [];
  const client = {
    chat: {
      completions: {
        create: async (payload) => {
          modelCalls.push(payload);
          if (modelCalls.length === 4) {
            await fs.writeFile(
              sourcePath,
              "# Durable report\n\nA host-side interruption revised this artifact between model turns.\n",
              "utf8"
            );
          }
          const response = scriptedResponses.shift();
          if (!response) throw new Error("duplicate canvas smoke exhausted scripted responses");
          return response;
        },
      },
    },
  };
  const clientFactory = async () => client;
  clientFactory.agintiDeterministicTest = true;
  const idempotencySessionId = "canvas-idempotency-smoke";
  const idempotencyConfig = resolveRuntimeConfig(
    {
      provider: "openai",
      routingMode: "manual",
      model: "scripted-canvas-model",
      goal: "Read durable-report.md, send each distinct content revision to canvas once, and finish without editing it yourself.",
      commandCwd: workspace,
      allowFileTools: true,
      allowShellTool: false,
      maxSteps: 6,
    },
    {
      baseDir: root,
      packageDir: repoRoot,
      provider: "openai",
      routingMode: "manual",
      model: "scripted-canvas-model",
      sessionId: idempotencySessionId,
      commandCwd: workspace,
      allowFileTools: true,
      allowShellTool: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      clientFactory,
    }
  );
  Object.assign(idempotencyConfig, {
    apiKey: "scripted-test-only",
    sessionsDir,
    projectSessionsDir: path.join(workspace, ".aginti-sessions"),
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    allowFileTools: true,
    allowShellTool: false,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    scsActive: false,
    enableScs: "off",
    executionPolicy: {
      tier: "focused",
      requiresPlan: false,
      reason: "Scripted canvas idempotency regression.",
    },
    clientFactory,
    modelTimeoutMs: 1_000,
  });
  const idempotencyRun = await runAgent(idempotencyConfig);
  const idempotencyStore = new SessionStore(sessionsDir, idempotencySessionId, {
    projectRoot: workspace,
    commandCwd: workspace,
    projectSessionsDir: idempotencyConfig.projectSessionsDir,
  });
  const idempotencyEvents = await idempotencyStore.loadEvents();
  const deliveredItems = idempotencyEvents.filter((event) => event.type === "canvas.item");
  const suppressedItems = idempotencyEvents.filter(
    (event) => event.type === "canvas.duplicate_suppressed"
  );
  const duplicateToolResult = idempotencyEvents.find(
    (event) =>
      event.type === "tool.completed" &&
      event.data?.category === "duplicate-canvas-delivery"
  );
  if (idempotencyRun.result !== "Sent the initial report once and its revised content once.") {
    throw new Error(`canvas idempotency run did not finish: ${idempotencyRun.result}`);
  }
  if (modelCalls.length !== 5 || scriptedResponses.length !== 0) {
    throw new Error(`canvas idempotency run used ${modelCalls.length} model calls`);
  }
  if (deliveredItems.length !== 2 || suppressedItems.length !== 1) {
    throw new Error(
      `expected two content-revision deliveries and one suppression, got ${deliveredItems.length}/${suppressedItems.length}`
    );
  }
  if (deliveredItems[0].data?.artifactId !== suppressedItems[0].data?.artifactId) {
    throw new Error("duplicate canvas suppression did not retain the original artifact identity");
  }
  if (
    duplicateToolResult?.data?.ok !== true ||
    duplicateToolResult?.data?.skipped !== true ||
    !/finish now/i.test(duplicateToolResult?.data?.reason || "")
  ) {
    throw new Error("duplicate canvas result did not redirect the fallback model toward completion");
  }
  const idempotencyState = await idempotencyStore.loadState();
  if (idempotencyState.meta?.canvasDeliveries?.length !== 2) {
    throw new Error("canvas delivery ledger did not retain exactly the two content revisions");
  }
  const canvasToolEntries = (idempotencyState.meta?.toolLoop?.recent || []).filter(
    (entry) => entry.toolName === "send_to_canvas"
  );
  if (
    canvasToolEntries.length !== 3 ||
    canvasToolEntries[0].successfulMutation !== true ||
    canvasToolEntries[1].successfulMutation !== false ||
    canvasToolEntries[2].successfulMutation !== true
  ) {
    throw new Error("duplicate canvas delivery was still credited as runtime progress");
  }
  const persistedCanvasFiles = await fs.readdir(
    path.join(idempotencyStore.artifactsDir, "canvas")
  );
  if (persistedCanvasFiles.length !== 2) {
    throw new Error(`duplicate canvas delivery persisted ${persistedCanvasFiles.length} snapshots`);
  }
  const persistedCanvasContents = await Promise.all(
    persistedCanvasFiles.map((filename) =>
      fs.readFile(path.join(idempotencyStore.artifactsDir, "canvas", filename), "utf8")
    )
  );
  if (
    !persistedCanvasContents.some((content) => content.includes("survive canvas preview cleanup")) ||
    !persistedCanvasContents.some((content) => content.includes("host-side interruption revised"))
  ) {
    throw new Error("canvas idempotency snapshots did not preserve both distinct file revisions");
  }

  const genericNamed = normalizeCanvasPayload(
    {
      title: "Fluorescence Experiment Analysis",
      kind: "pdf",
      path: "report.pdf",
    },
    config
  );
  if (!genericNamed.ok || genericNamed.payload.downloadName !== "Fluorescence-Experiment-Analysis.pdf") {
    throw new Error(`generic artifact did not receive a task-meaningful filename: ${genericNamed.payload?.downloadName}`);
  }

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
  if (content.filename !== "durable-report.md") throw new Error("artifact read metadata lost the download filename");

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
