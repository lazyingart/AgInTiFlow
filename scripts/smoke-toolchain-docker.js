#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readArtifactContent } from "../src/artifact-tunnel.js";
import { evaluateCommandPolicy } from "../src/command-policy.js";
import { runDockerPreflight, runDockerSandboxCommand } from "../src/docker-sandbox.js";
import { resolveRuntimeConfig } from "../src/config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-toolchain-"));
const runtimeDir = path.join(tempRoot, "runtime");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runToolchainCommand(command, config) {
  const policy = evaluateCommandPolicy(command, config);
  assert(policy.allowed, `${command} was blocked: ${policy.reason || policy.category}`);
  return runDockerSandboxCommand(command, config, policy);
}

try {
  const config = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "",
      commandCwd: workspace,
      maxSteps: 1,
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      commandCwd: workspace,
      allowShellTool: true,
      allowFileTools: true,
      useDockerSandbox: true,
      sandboxMode: "docker-workspace",
      packageInstallPolicy: "block",
      dockerSandboxImage: process.env.AGINTIFLOW_TOOLCHAIN_IMAGE || "agintiflow-sandbox:latest",
    }
  );

  const preflight = await runDockerPreflight(config, { buildImage: false });
  assert(preflight.ok, "Docker toolchain preflight failed. Run scripts/setup-agent-toolchain-docker.sh first.");

  await fs.writeFile(
    path.join(workspace, "plot_fx.py"),
    [
      "import math",
      "import matplotlib",
      "matplotlib.use('Agg')",
      "import matplotlib.pyplot as plt",
      "xs = [x / 20 for x in range(-60, 61)]",
      "ys = [x + math.exp(x) for x in xs]",
      "fig, ax = plt.subplots(figsize=(7, 4.4), dpi=160)",
      "ax.plot(xs, ys, color='#0065c9', linewidth=2.5)",
      "ax.axhline(0, color='#6b7280', linewidth=0.8)",
      "ax.axvline(0, color='#6b7280', linewidth=0.8)",
      "ax.grid(True, alpha=0.25)",
      "ax.set_title('f(x) = x + e^x')",
      "ax.set_xlabel('x')",
      "ax.set_ylabel('f(x)')",
      "fig.tight_layout()",
      "fig.savefig('plot_fx.svg')",
      "",
    ].join("\n"),
    "utf8"
  );
  await runToolchainCommand("python3 plot_fx.py", config);
  const svg = await fs.readFile(path.join(workspace, "plot_fx.svg"), "utf8");
  assert(svg.includes("<svg"), "Python plot did not produce an SVG file");

  await fs.writeFile(
    path.join(workspace, "paper.tex"),
    [
      "\\documentclass{article}",
      "\\usepackage[T1]{fontenc}",
      "\\usepackage{amsmath}",
      "\\title{AgInTiFlow Toolchain Smoke}",
      "\\author{AgInTiFlow}",
      "\\date{}",
      "\\begin{document}",
      "\\maketitle",
      "This smoke test verifies that the companion Docker sandbox can compile a PDF.",
      "\\[ f(x) = x + e^x, \\qquad f'(x) = 1 + e^x. \\]",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await runToolchainCommand("latexmk -pdf -interaction=nonstopmode -halt-on-error paper.tex", config);
  const pdfStat = await fs.stat(path.join(workspace, "paper.pdf"));
  assert(pdfStat.size > 1000, "LaTeX did not produce a useful PDF file");

  const pdfPreview = await readArtifactContent(
    {
      id: "smoke-pdf",
      kind: "pdf",
      title: "Toolchain PDF",
      path: "paper.pdf",
      ref: { type: "workspace-file", path: "paper.pdf", commandCwd: workspace },
    },
    { config }
  );
  assert(pdfPreview.ok && pdfPreview.kind === "pdf", "PDF artifact preview was not renderable");
  assert(/^data:application\/pdf;base64,/.test(pdfPreview.dataUrl || ""), "PDF artifact did not return a PDF data URL");

  await fs.mkdir(path.join(workspace, "figure-note"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "figure-note", "make_figure.py"),
    [
      "import math",
      "import matplotlib",
      "matplotlib.use('Agg')",
      "import matplotlib.pyplot as plt",
      "xs = [x / 20 for x in range(-40, 41)]",
      "ys = [x + math.exp(x) for x in xs]",
      "fig, ax = plt.subplots(figsize=(6, 3.5))",
      "ax.plot(xs, ys, color='#0065c9', linewidth=2.2)",
      "ax.set_title('f(x)=x+e^x')",
      "ax.set_xlabel('x')",
      "ax.set_ylabel('f(x)')",
      "ax.grid(True, alpha=0.25)",
      "fig.tight_layout()",
      "fig.savefig('figure-note/fx_figure.pdf')",
      "",
    ].join("\n"),
    "utf8"
  );
  await runToolchainCommand("python3 figure-note/make_figure.py", config);

  await fs.writeFile(
    path.join(workspace, "figure-note", "figure_note.tex"),
    [
      "\\documentclass{article}",
      "\\usepackage[T1]{fontenc}",
      "\\usepackage{amsmath}",
      "\\usepackage{graphicx}",
      "\\title{Figure-Included Toolchain Smoke}",
      "\\author{AgInTiFlow}",
      "\\date{}",
      "\\begin{document}",
      "\\maketitle",
      "The generated figure below is included from a workspace subfolder.",
      "\\[ f(x)=x+e^x \\]",
      "\\begin{figure}[h]",
      "\\centering",
      "\\includegraphics[width=0.8\\linewidth]{fx_figure.pdf}",
      "\\caption{Generated plot of $f(x)=x+e^x$.}",
      "\\end{figure}",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await runToolchainCommand("latexmk -cd -pdf -interaction=nonstopmode -halt-on-error figure-note/figure_note.tex", config);
  const figureNotePdf = await fs.stat(path.join(workspace, "figure-note", "figure_note.pdf"));
  assert(figureNotePdf.size > 1000, "Figure-included LaTeX note did not produce a PDF file");

  console.log(
    JSON.stringify(
      {
        ok: true,
        image: config.dockerSandboxImage,
        workspace,
        outputs: ["plot_fx.svg", "paper.pdf", "figure-note/fx_figure.pdf", "figure-note/figure_note.pdf"],
        artifactKinds: ["image/svg+xml", "application/pdf"],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
