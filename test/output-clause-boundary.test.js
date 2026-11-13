import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { deriveScsTaskContract } = await import(pathToFileURL(path.join(runtime, "src/scs-evidence.js")));
const goal = "Can you compare the two builds in readings.csv? There are blanks and NA values. Use Python to check the usable count, missing count, mean and median for each build. Save comparison.csv and a short report.md explaining what the data says. Leave readings.csv and keep.txt as they are.";
for (const prompt of [goal, "Check input.csv. Save report.md.", "Validate input.csv; create report.md.", "Read input.csv and verify the numbers. Write report.md.", "Read input.csv. Verify it first! Save report.md.", "Check input.csv。Save report.md.", "Check `input. notes.csv`. Save report.md.", "Validate input.csv. Save `report.md`.", "Don't check input.csv. Save report.md.", "Do not run `python check.py`; save report.md."]) test(`a prior verifier sentence does not erase a later output: ${prompt}`, () => {
  const contract = deriveScsTaskContract({ goal: prompt, taskProfile: "data" });
  assert.deepEqual(contract.exactOutputPaths, prompt === goal ? ["comparison.csv", "report.md"] : ["report.md"]);
  assert.equal(contract.exactOutputPaths.includes("input.csv"), false);
  assert.equal(contract.exactOutputPaths.includes("readings.csv"), false);
});
for (const prompt of ["Run `python check.py --output report.md`.", "Check `tool --save report.md`.", "Explain `check input.csv; save report.md`.", "Print 'check input.csv. Save report.md'.", "Check input.csv. Do not save report.md.", "Check input.csv. Never create report.md.", "Don't check input.csv and save report.md.", "Run `printf 'check input.csv. Save report.md'`.", 'Explain "Check input.csv; Save report.md".', 'Check input.csv then print "save report.md".']) test(`command/prose/negative text grants no later output: ${prompt}`, () => {
  assert.deepEqual(deriveScsTaskContract({ goal: prompt, taskProfile: "auto" }).exactOutputPaths, []);
});
