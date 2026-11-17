import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { deriveScsTaskContract } = await import(pathToFileURL(path.join(root, "src/scs-evidence.js")));
const contract = goal => deriveScsTaskContract({ goal, taskProfile: "code" });

for (const [label, goal, outputs, inputs] of [
  ["collective suffix", "Update src/store.js. Write tests in test/store.test.js. Keep README.md, package.json and other files unchanged.", ["src/store.js", "test/store.test.js"], ["README.md", "package.json"]],
  ["all other files", "Update main.js. Keep config.json and all other files unchanged.", ["main.js"], ["config.json"]],
  ["remaining files", "Write result.csv in reports/. Leave source.md and the remaining files untouched.", ["reports/result.csv"], ["source.md"]],
  ["everything else", "Write result.csv. Preserve source.md and everything else as-is.", ["result.csv"], ["source.md"]],
  ["directory is clause-local", "Write one.txt in alpha/. Write two.txt in beta/.", ["alpha/one.txt", "beta/two.txt"], []],
  ["later read is not a write", "Write report.txt in out/. Read guide.md.", ["out/report.txt"], ["guide.md"]],
  ["later unrelated filename", "Write result.txt in out/. The reference is source.csv.", ["out/result.txt"], ["source.csv"]],
  ["quoted dotted filename", 'Write "release. notes.txt" in out/. Keep "source. notes.md" unchanged.', ["out/release. notes.txt"], ["source. notes.md"]],
  ["ES module output", "Update src/parser.mjs. Write test/parser.test.mjs. Keep README.md unchanged.", ["src/parser.mjs", "test/parser.test.mjs"], ["README.md"]],
  ["CommonJS module output", "Update src/parser.cjs. Write test/parser.test.cjs. Keep config.json unchanged.", ["src/parser.cjs", "test/parser.test.cjs"], ["config.json"]],
  ["ES module input", "Read src/parser.mjs. Write result.txt.", ["result.txt"], ["src/parser.mjs"]],
  ["CommonJS module input", "Read src/parser.cjs. Write result.txt.", ["result.txt"], ["src/parser.cjs"]],
  ["existing named inputs", "Update src/entry.mjs. Keep the existing README.md and all other files unchanged.", ["src/entry.mjs"], ["README.md"]],
]) test(`output authority: ${label}`, () => {
  const result = contract(goal);
  assert.deepEqual([...result.exactOutputPaths].sort(), [...outputs].sort());
  assert.deepEqual([...result.exactInputPaths].sort(), [...inputs].sort());
});

for (const name of ["guide.md", "source.pdf", "source.tex", "source.png"]) {
  test(`preserving ${name} is not a format deliverable`, () => {
    const result = contract(`Update main.js. Keep ${name} unchanged.`);
    assert.deepEqual(result.exactOutputPaths, ["main.js"]);
    assert.deepEqual(result.requiredArtifactKinds, []);
  });
}

test("an earlier affirmative deliverable remains required after preservation", () => {
  const result = contract("Create final.md in out/. Keep out/final.md unchanged.");
  assert.deepEqual(result.exactOutputPaths, ["out/final.md"]);
  assert.ok(result.requiredArtifactKinds.some(item => item.extension === ".md"));
});

test("collective preservation does not suppress a later positive output", () => {
  const result = contract("Keep source.md and other files unchanged. Write report.md in results/.");
  assert.deepEqual(result.exactOutputPaths, ["results/report.md"]);
  assert.ok(result.requiredArtifactKinds.some(item => item.extension === ".md"));
  assert.ok(result.exactInputPaths.includes("source.md"));
});

test("ordinary coding task has no invented documentation output or format", () => {
  const goal = "Please fix src/note-store.mjs using the README contract. Editing should update the same note, not add another, stay inside the caller's account and reject stale edits. Add useful regression tests in test/note-store.test.mjs and actually run them. Keep README.md, package.json and other files unchanged. Use Node built-ins only; don't install anything or commit.";
  const result = contract(goal);
  assert.equal(result.exactOutputPaths.some(file => /(?:^|\/)(?:README\.md|package\.json)$/.test(file)), false);
  assert.deepEqual(result.requiredArtifactKinds, []);
  assert.ok(result.preservedInputPaths.includes("README.md"));
  assert.ok(result.preservedInputPaths.includes("package.json"));
});

for (const phrase of ["Keep all Markdown files unchanged.", "Leave existing PDF files untouched.", "Preserve all *.md files as-is."]) {
  test(`unnamed preservation suppresses output intent without inventing paths: ${phrase}`, () => {
    const result = contract(`Update src/main.js. ${phrase}`);
    assert.deepEqual(result.exactOutputPaths, ["src/main.js"]);
    assert.deepEqual(result.requiredArtifactKinds, []);
    assert.deepEqual(result.preservedInputPaths, []);
  });
}

test("quoted preservation example does not elect a deliverable", () => {
  const result = contract("Explain the phrase 'keep Markdown files unchanged'.");
  assert.deepEqual(result.exactOutputPaths, []);
  assert.deepEqual(result.requiredArtifactKinds, []);
});
