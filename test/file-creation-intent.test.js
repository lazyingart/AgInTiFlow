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
