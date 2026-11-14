import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { deriveScsTaskContract } = await import(pathToFileURL(path.join(root, "src/scs-evidence.js")));
const categories = goal => deriveScsTaskContract({ goal, taskProfile: "research" }).requiredEvidence.map(e => e.category);
for (const goal of [
  "Can you make the note shorter without losing either version link or its reported score? Leave unrelated files alone.",
  "Please make this paragraph clearer.",
  "Make a concise Markdown note and save note.md.",
  "Could you make a comparison table in comparison.md?",
  "Make the English wording more natural.",
  "Make all the notes consistent.",
  "Explain how `make test` works; do not run it.",
  "Please edit note.md to make it shorter. Keep keep.txt unchanged.",
]) test(`ordinary make wording invents no process obligation: ${goal}`, () => {
  assert.equal(categories(goal).includes("command"), false);
});
for (const goal of [
  "Run make test.", "Please execute `make check`.", "Execute make test, then create report.md.", "Run the following command: `make all`.",
  "Use GNU Make to build the project.", "make test", "make -C src check", "`make custom-target`",
  "Make the note shorter, then run `make check`.", "Make the note shorter, then run npm test.",
]) test(`actual command execution still needs command proof: ${goal}`, () => {
  assert.equal(categories(goal).includes("command"), true);
});
test("explicit note creation retains file evidence after removing the false command obligation", () => {
  assert.ok(categories("Make a concise Markdown note and save note.md.").includes("file"));
});
