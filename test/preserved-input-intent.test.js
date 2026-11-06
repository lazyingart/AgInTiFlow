import assert from "node:assert/strict";
import test from "node:test";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

for (const [label, goal, inputs, outputs] of [
  ["separate preservation sentence", "Read note.txt and save a concise summary.md. Keep note.txt unchanged.", ["note.txt"], ["summary.md"]],
  ["coordinated input list", "Read a.txt and b.txt, save result.md, and keep a.txt and b.txt unchanged.", ["a.txt", "b.txt"], ["result.md"]],
  ["preserve without explicit read", "Create report.md and leave source.md untouched.", ["source.md"], ["report.md"]],
  ["quoted input path", 'Read "source notes.txt" and write report.md; preserve "source notes.txt" as-is.', ["source notes.txt"], ["report.md"]],
  ["wrapped preserved list", "Create report.md, keep a.txt and\nb.txt unchanged.", ["a.txt", "b.txt"], ["report.md"]],
  ["Chinese preservation", "读取 input.txt，保存 result.md。保持 input.txt 不变。", ["input.txt"], ["result.md"]],
  ["traditional preservation", "讀取 input.txt，保存 result.md。保留 input.txt 原樣。", ["input.txt"], ["result.md"]],
  ["postfix unchanged input", "Read input.txt and save report.md. input.txt must remain unchanged.", ["input.txt"], ["report.md"]],
  ["verb-like filename", "Read write.txt and create report.md. Keep write.txt unchanged.", ["write.txt"], ["report.md"]],
  ["new output then preservation", "Create report.md, then keep report.md unchanged.", [], ["report.md"]],
  ["retained delivery output", "Save final.pdf for delivery. Keep final.pdf unchanged.", [], ["final.pdf"]],
  ["source mutation with partial preservation", "Read source.js and update source.js. Keep formatting unchanged.", [], ["source.js"]],
]) test(`file intent preserves ${label}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.deepEqual([...contract.exactInputPaths].sort(), [...inputs].sort());
  assert.deepEqual([...contract.exactOutputPaths].sort(), [...outputs].sort());
});
