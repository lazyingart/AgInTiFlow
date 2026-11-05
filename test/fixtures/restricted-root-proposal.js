import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRestrictedApplicationRunner, createRestrictedDeepSeekProvider } from "../../src/restricted-application.js";

const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: "string", minLength: 1, maxLength: 400 };
const schema = { type: "array", minItems: 2, maxItems: 2, items: object({ id: text, revision: { type: "integer", minimum: 1 }, text }) };
const plain = value => JSON.parse(JSON.stringify(value));

// Host-owned synthetic records/history; the SDK only returns a proposal. The
// transport is injected so identical ordinary prompts run offline and live.
export async function runRootProposalScenario(complete, directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  const results = [];
  for (const [model, language] of [["deepseek-flash", "en"], ["deepseek-v4-pro", "zh"]]) {
    const values = language === "en" ? [
      { id: "item-a", revision: 7, text: "Collect the cyan folder on Thursday." },
      { id: "item-b", revision: 12, text: "Keep the USB adapter in the side pocket." },
    ] : [
      { id: "item-a", revision: 8, text: "周四取青色文件夹。" },
      { id: "item-b", revision: 13, text: "转接头放在侧袋，不要混到主袋。" },
    ];
    const filename = path.join(directory, `${language}-records.json`);
    await fs.writeFile(filename, JSON.stringify(values), { mode: 0o600 });
    const before = await fs.readFile(filename);
    let reads = 0;
    const runner = createRestrictedApplicationRunner({
      provider: createRestrictedDeepSeekProvider({ model, complete }),
      instructions: "Read current authorized items before returning their exact id, revision and text in source order. History may be stale. Return an uncommitted proposal; never save or invent records.",
      tools: [{ name: "read_current_items", description: "Read all items authorized for this caller in their current order.", readOnly: true,
        inputSchema: object({}), outputSchema: schema,
        execute: async () => { reads++; return JSON.parse(await fs.readFile(filename, "utf8")); } }],
      outputSchema: schema,
      limits: { maxSteps: 2, maxToolCalls: 1, maxCallsPerStep: 1, maxOutputTokens: 2048, timeoutMs: 45_000 },
    });
    const prompt = language === "en"
      ? "Could you list both items as they are now, keep the order, no saves please."
      : "把这两条现在的内容列一下，顺序别换，别保存修改。";
    const history = [{ role: "assistant", text: language === "en" ? "Earlier draft said Wednesday and revision 1; it may be stale." : "上一轮的草稿是周三、版本1，可能已经过时。" }];
    const result = await runner.run({ input: [{ type: "text", text: prompt }], history });
    assert.equal(reads, 1); assert.equal(result.usage.steps, 2); assert.equal(result.usage.toolCalls, 1);
    assert.deepEqual(plain(result.proposal), values);
    assert.deepEqual(await fs.readFile(filename), before);
    results.push({ model, language, prompt, result, reads, stateUnchanged: true });
  }
  return results;
}
