import assert from "node:assert/strict";
import test from "node:test";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

for (const goal of [
  "Read note.txt and leave it unchanged. Make a short summary.md of what's still blocked and what's already done.",
  "Please make a brief report.md from the supplied notes.",
  "Make me a new checklist.json.",
  "Make two files: first.md and second.md.",
  "Create a short summary.md.",
  "Write answer.md with the result.",
  "Update summary.md with the supplied correction.",
]) test(`natural named-file creation: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.equal(contract.requiresFileMutation, true);
  assert.equal(contract.requiresWorkspaceMutation, true);
  assert.ok(contract.requiredEvidence.some(item => item.category === "file"));
  assert.equal(contract.requiredEvidence.some(item => item.category === "command"), false);
  assert.ok(contract.exactOutputPaths.length);
  assert.equal(contract.exactOutputPaths.includes("note.txt"), false);
});

for (const goal of [
  "Do not make a file named report.md. Explain the idea only.",
  "Make a summary of this paragraph in your answer.",
  "Create one useful inspiration point. Replace the prior invalid inspiration. Return one corrected chat response. Create no files.",
  "Correct the previous reply in Chinese. Do not create any file.",
]) test(`no invented file mutation: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal });
  assert.equal(contract.requiresFileMutation, false);
  assert.equal(contract.requiresWorkspaceMutation, false);
  assert.deepEqual(contract.exactOutputPaths, []);
});

for (const goal of [
  "Run make summary.md and verify the result.",
  "Run `make summary.md`.",
  "Execute make test, then create report.md.",
  "Make a report.md and run npm test.",
]) test(`explicit command authority remains required: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.ok(contract.requiredEvidence.some(item => item.category === "command"));
});

for (const [goal, outputs, inputs, preserved] of [
  ["Create summary.md from note.txt. Leave note.txt unchanged.", ["summary.md"], ["note.txt"], ["note.txt"]],
  ["Create summary.md from note.txt.", ["summary.md"], ["note.txt"], []],
  ["Make report.md using notes.txt.", ["report.md"], ["notes.txt"], []],
  ["Write report.md based on notes.txt. Keep notes.txt intact.", ["report.md"], ["notes.txt"], ["notes.txt"]],
  ["Create summary.md from inputs/note.txt. Leave inputs/note.txt unchanged.", ["summary.md"], ["inputs/note.txt"], ["inputs/note.txt"]],
  ["Create report.md and checklist.md from a.txt and b.txt.", ["report.md", "checklist.md"], ["a.txt", "b.txt"], []],
  ["Write report.md from a.txt, then write checklist.md using b.txt.", ["report.md", "checklist.md"], ["a.txt", "b.txt"], []],
  ["Create report.md and read note.txt. Keep note.txt unchanged.", ["report.md"], ["note.txt"], ["note.txt"]],
  ["Create `report.md` from `inputs/current notes.txt`.", ["report.md"], ["inputs/current notes.txt"], []],
  ["Create from.md and using.txt.", ["from.md", "using.txt"], [], []],
  ["Create a read-only report.md.", ["report.md"], [], []],
  ["Create a reference document reference.md.", ["reference.md"], [], []],
  ["Create a load test load-test.py.", ["load-test.py"], [], []],
  ["从 note.txt 生成 summary.md。保持 note.txt 不变。", ["summary.md"], ["note.txt"], ["note.txt"]],
  ["生成 summary.md，使用 note.txt。保持 note.txt 不变。", ["summary.md"], ["note.txt"], ["note.txt"]],
  ["Create intermediate.md. Then use intermediate.md to write final.md.", ["intermediate.md", "final.md"], [], []],
]) test(`input/output roles follow the clause, not path order: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.deepEqual(contract.exactOutputPaths, outputs);
  assert.deepEqual(contract.exactInputPaths, inputs);
  assert.deepEqual(contract.preservedInputPaths, preserved);
});
