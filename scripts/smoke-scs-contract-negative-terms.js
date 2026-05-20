#!/usr/bin/env node
import assert from "node:assert/strict";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

const shijiLikeGoal = [
  "# Shiji Pilot Repair And Run",
  "Use AgInTi/DeepSeek only. Do not use Codex, `codex exec`, or any Codex wrapper.",
  "Do not rely on `bash -n` only. The script must actually compile.",
  "## Required Final Pilot Outputs",
  "- `books/shiji/work/aginti/generate_chunk.py`",
  "- `data/interlinear/shiji-aginti/chunks/shiji-chunk-0003.json`",
  "- `build/shiji-aginti/jp-main/color/史記（中文注）.pdf`",
  "- `build/shiji-aginti/jp-main/blackwhite/史記（中文注・白黒）.pdf`",
  "Fix `render_three_layer_tex.py` before compiling:",
  "- Include a title page with `史記` and author `司馬遷` annotated with pinyin and Japanese furigana where appropriate.",
].join("\n");

const contract = deriveScsTaskContract({ goal: shijiLikeGoal, taskProfile: "latex" });

assert(
  contract.exactOutputPaths.includes("data/interlinear/shiji-aginti/chunks/shiji-chunk-0003.json"),
  "required output headings without a colon should preserve listed JSON outputs"
);
assert(
  contract.exactOutputPaths.includes("build/shiji-aginti/jp-main/color/史記（中文注）.pdf"),
  "required output headings should preserve CJK PDF paths"
);
assert(!contract.requiredTextTerms.includes("codex exec"), "forbidden action terms must not become required text");
assert(!contract.requiredTextTerms.includes("bash -n"), "negated tool terms must not become required text");
assert(contract.requiredTextTerms.includes("史記"), "positive required title text should remain required");
assert(contract.requiredTextTerms.includes("司馬遷"), "positive required author text should remain required");

console.log(JSON.stringify({ ok: true, exactOutputPaths: contract.exactOutputPaths, requiredTextTerms: contract.requiredTextTerms }, null, 2));
