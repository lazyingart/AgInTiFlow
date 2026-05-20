#!/usr/bin/env node
import assert from "node:assert/strict";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

const artifactGoal = [
  "# Artifact Pipeline Pilot Repair And Run",
  "Use AgInTi/DeepSeek only. Do not use Codex, `codex exec`, or any Codex wrapper.",
  "Do not rely on `bash -n` only. The script must actually compile.",
  "## Required Final Pilot Outputs",
  "- `work/pipeline/generate_artifact.py`",
  "- `data/pipeline/chunks/chunk-0003.json`",
  "- `build/pipeline/primary/color/Annotated_Report.pdf`",
  "- `build/pipeline/primary/blackwhite/Annotated_Report_BW.pdf`",
  "- `build/pipeline/unicode/成果.pdf`",
  "Fix `render_artifact_tex.py` before compiling:",
  "- Include a title page with `Annotated Report` and author `Example Author`.",
].join("\n");

const contract = deriveScsTaskContract({ goal: artifactGoal, taskProfile: "latex" });

assert(
  contract.exactOutputPaths.includes("data/pipeline/chunks/chunk-0003.json"),
  "required output headings without a colon should preserve listed JSON outputs"
);
assert(
  contract.exactOutputPaths.includes("build/pipeline/unicode/成果.pdf"),
  "required output headings should preserve generic Unicode PDF paths"
);
assert(!contract.requiredTextTerms.includes("codex exec"), "forbidden action terms must not become required text");
assert(!contract.requiredTextTerms.includes("bash -n"), "negated tool terms must not become required text");
assert(contract.requiredTextTerms.includes("Annotated Report"), "positive required title text should remain required");
assert(contract.requiredTextTerms.includes("Example Author"), "positive required author text should remain required");

console.log(JSON.stringify({ ok: true, exactOutputPaths: contract.exactOutputPaths, requiredTextTerms: contract.requiredTextTerms }, null, 2));
