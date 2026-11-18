import assert from "node:assert/strict";
import {
  createRestrictedApplicationRunner, createRestrictedDeepSeekProvider, createRestrictedOpenAIProvider,
} from "@lazyingart/agintilite";
import { createRestrictedDeepSeekClient } from "@lazyingart/agintilite/deepseek-http";

const schema = { type: "object", properties: { reply: { type: "string", maxLength: 30 } }, required: ["reply"], additionalProperties: false };
for (const model of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.4-mini"]) {
  const isOpenAI = model === "gpt-5.4-mini";
  let calls = 0;
  function complete(body) {
    calls++;
    assert.equal(body.model, model);
    assert.equal(body[isOpenAI ? "max_completion_tokens" : "max_tokens"], 128);
    assert.equal(Object.hasOwn(body, isOpenAI ? "max_tokens" : "max_completion_tokens"), false);
    assert.equal(Object.hasOwn(body, "tools"), false);
    return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"reply":"Ready"}' } }] };
  }
  if (!isOpenAI) {
    const client = createRestrictedDeepSeekClient({ model, apiKey: "offline-test-key-only", userId: "synthetic_user_001" });
    await client.close();
  }
  const provider = isOpenAI ? createRestrictedOpenAIProvider({ model, supportsImages: false, complete })
    : createRestrictedDeepSeekProvider({ model, complete });
  const app = createRestrictedApplicationRunner({
    provider, instructions: "Answer from the supplied record.", outputSchema: schema, tools: [],
    limits: { maxSteps: 1, maxOutputTokens: 128 },
  });
  const answer = await app.run({ input: [{ type: "text", text: "Is my draft ready?" }] });
  assert.equal(answer.proposal.reply, "Ready");
  assert.equal(calls, 1);
}
