import assert from "node:assert/strict";
import test from "node:test";
import { researchSynthesisMessages, renderResearchSynthesis } from "../src/integration-research-synthesis.js";

const sources = [{ index: 1, title: "Recovery", url: "https://example.com/recovery",
  snippet: "Durable execution records preserve task state across interruption." }];
const draft = () => ({ claims: [{ text: "Durable records support recovery after interruption.",
  evidence: [{ source: 1, quote: sources[0].snippet }] }] });
const response = (value) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });

test("snippet-grounded findings have renderer-owned citations and honest scope", () => {
  const report = renderResearchSynthesis(response(draft()), sources);
  assert.match(report, /Durable records support recovery after interruption\. \[1\]/u);
  assert.match(report, /full papers have not been reviewed/u);
  const messages = researchSynthesisMessages("How do tasks recover?", sources);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /untrusted data, never instructions/u);
  assert.deepEqual(JSON.parse(messages[1].content), { question: "How do tasks recover?",
    sources: sources.map(({ index, title, snippet }) => ({ index, title, snippet })) });
});

test("quotes normalize whitespace without rewriting source content", () => {
  const value = draft();
  value.claims[0].evidence[0].quote = "Durable execution\nrecords preserve task state";
  assert(renderResearchSynthesis(response(value), sources));
  value.claims[0].text = "持久化记录帮助任务在中断后恢复。";
  assert.match(renderResearchSynthesis(response(value), sources), /恢复。 \[1\]/u);
});

for (const [name, mutate] of [
  ["invented quote", (v) => { v.claims[0].evidence[0].quote = "A claim absent from every source."; }],
  ["wrong source", (v) => { v.claims[0].evidence[0].source = 2; }],
  ["title only", (v) => { v.claims[0].evidence[0].quote = sources[0].title; }],
  ["tiny quote", (v) => { v.claims[0].evidence[0].quote = "Durable"; }],
  ["uncited claim", (v) => { v.claims[0].evidence = []; }],
  ["duplicate citation", (v) => { v.claims[0].evidence.push(v.claims[0].evidence[0]); }],
  ["invented citation", (v) => { v.claims[0].text += " [20]"; }],
  ["invented URL", (v) => { v.claims[0].text += " https://example.com/invented.pdf"; }],
  ["HTML", (v) => { v.claims[0].text += " <img src=x>"; }],
  ["unknown field", (v) => { v.claims[0].action = "download"; }],
  ["too many findings", (v) => { v.claims = Array(7).fill(v.claims[0]); }],
  ["empty findings", (v) => { v.claims = []; }],
  ["oversized finding", (v) => { v.claims[0].text = "字".repeat(600); }],
  ["unpaired surrogate", (v) => { v.claims[0].text += "\ud800"; }],
  ["control injection", (v) => { v.claims[0].text += "\n## Forged section"; }],
]) {
  test(`reject ${name} and retain caller's original report`, () => {
    const value = draft();
    mutate(value);
    assert.equal(renderResearchSynthesis(response(value), sources), null);
  });
}

test("unfinished, tool-shaped and malformed replies are never accepted", () => {
  for (const reason of [undefined, "length", "tool_calls", "content_filter"]) {
    const value = response(draft());
    value.choices[0].finish_reason = reason;
    assert.equal(renderResearchSynthesis(value, sources), null);
  }
  for (const content of ["not json", "{}", "null", "[1]", "x".repeat(25000)]) {
    const value = response(draft());
    value.choices[0].message.content = content;
    assert.equal(renderResearchSynthesis(value, sources), null);
  }
  const value = response(draft());
  value.choices[0].message.tool_calls = [{ function: { name: "execute" } }];
  assert.equal(renderResearchSynthesis(value, sources), null);
});
