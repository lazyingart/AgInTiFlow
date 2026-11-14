import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { hasSensitiveText, redactSensitiveText, redactValue } = await import(pathToFileURL(path.join(root, "src/redaction.js")));
const { createRestrictedApplicationRunner, createRestrictedOpenAIProvider, createRestrictedDeepSeekProvider } = await import(pathToFileURL(path.join(root, "src/restricted-application.js")));
const fake = "DEMO_ONLY_NOT_A_REAL_CREDENTIAL";
const schema = { type: "object", properties: { reply: { type: "string", maxLength: 1000 } }, required: ["reply"], additionalProperties: false };
const object = { type: "object", properties: {}, required: [], additionalProperties: false };
const input = text => ({ input: [{ type: "text", text }] });
const final = reply => ({ type: "final", value: { reply } });
const config = (complete, extra = {}) => ({ provider: { supportsImages: false, complete }, instructions: "Return an uncommitted proposal only.", tools: [], outputSchema: schema, ...extra });

for (const text of [
  JSON.stringify({ password: fake }), JSON.stringify({ api_key: fake }), JSON.stringify({ access_token: fake }),
  JSON.stringify({ accessToken: fake }), JSON.stringify({ refreshToken: fake }),
  `password="${fake}"`, `token = '${fake}'`, `apiKey: "${fake}"`, `{"Authorization":"Bearer ${fake}"}`,
  `{'password':'${fake}'}`, `"PASSWORD" : "${fake}"`, `{"data":{"refresh_token":"${fake}"}}`,
  String.raw`{"pass\u0077ord":"DEMO_ONLY_NOT_A_REAL_CREDENTIAL"}`,
  `password="${fake}`, `token='${fake}\nnext line`, `password="${fake}\\\"tail"`,
]) test(`quoted credential literal is removed: ${text.slice(0, 65)}`, () => {
  assert.equal(hasSensitiveText(text), true);
  const redacted = redactSensitiveText(text);
  assert.ok(!redacted.includes(fake));assert.match(redacted, /\[REDACTED\]/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

for (const value of ["", "false", "true", "null", "none", "unset", "missing", "not-set", "[REDACTED]", "***"]) test(`safe literal placeholder remains usable: ${JSON.stringify(value)}`, () => {
  for (const text of [JSON.stringify({ password: value }), `token='${value}'`]) {
    assert.equal(redactSensitiveText(text), text);assert.equal(hasSensitiveText(text), false);
  }
});
for (const text of [
  'token = os.environ.get("APP_TOKEN")', 'def authenticate(token: str | None) -> bool:',
  'print(f"token={token}")', 'headers = {"Authorization": "Bearer " + key}',
  'if line.startswith("DEEPSEEK_API_KEY="):',
  '{"title":"Public note","description":"No credential supplied"}',
  '{"api_key_rotation":"next month","token_count":"three"}',
  'The password policy is described in the public documentation.',
]) test(`ordinary text and credential-handling source stay unchanged: ${text.slice(0, 60)}`, () => {
  assert.equal(redactSensitiveText(text), text);assert.equal(hasSensitiveText(text), false);
});

test("JSON redaction preserves the outer shape and unrelated fields", () => {
  const value = { owner: "synthetic", password: fake, note: "leave this alone" };
  assert.deepEqual(JSON.parse(redactSensitiveText(JSON.stringify(value))), { ...value, password: "[REDACTED]" });
});
test("multiple inline assignments all redact, including escaped quoted keys", () => {
  const text = `password="${fake}"; api_key='${fake}'; {"pass\\u0077ord":"${fake}"}`;
  assert.equal(hasSensitiveText(text), true);assert.ok(!redactSensitiveText(text).includes(fake));
});

for (const name of ["password", "api_key", "Authorization", "access_token", "accessToken", "refreshToken"]) test(`structured credential field is masked without mutating caller: ${name}`, () => {
  const value = { note: "public", nested: [{ [name]: fake, remaining: "unchanged" }] };
  assert.deepEqual(redactValue(value), { note: "public", nested: [{ [name]: "[REDACTED]", remaining: "unchanged" }] });
  assert.equal(value.nested[0][name], fake);
});
test("structured safe placeholders and source-schema objects stay usable", () => {
  const value = { password: "", token: "[REDACTED]", Authorization: "Bearer ", schema: { password: { type: "string" } } };
  assert.deepEqual(redactValue(value), value);
});
test("long ordinary quoted data does not become a credential or change text", () => {
  const value = JSON.stringify({ description: "A public note. ".repeat(9000), token_count: "three" });
  assert.equal(redactSensitiveText(value), value);
});

for (const location of ["input", "user history", "assistant history", "instructions", "tool description"]) test(`restricted SDK rejects quoted credentials in ${location} before dispatch`, async () => {
  let calls = 0;const text = JSON.stringify({ password: fake });let request = input("Check this record, no changes please.");
  const options = config(() => { calls++;return final("Observed."); });
  if (location === "input") request = input(text);
  else if (location.endsWith("history")) request.history = [{ role: location.startsWith("user") ? "user" : "assistant", text }];
  else if (location === "instructions") options.instructions = text;
  else options.tools = [{ name: "read_note", description: text, readOnly: true, inputSchema: object, outputSchema: schema, execute: () => ({ reply: "Observed." }) }];
  await assert.rejects(async () => createRestrictedApplicationRunner(options).run(request), { code: "SENSITIVE_DATA" });
  assert.equal(calls, 0);
});

test("quoted credentials in a current read never reach a subsequent model turn", async () => {
  let calls = 0, reads = 0;
  const app = createRestrictedApplicationRunner(config(() => {
    calls++;return { type: "tool_calls", calls: [{ id: "read_1", name: "read_note", arguments: {} }] };
  }, { tools: [{ name: "read_note", description: "Read selected note.", readOnly: true, inputSchema: object, outputSchema: schema,
    execute() { reads++;return { reply: JSON.stringify({ password: fake }) }; } }] }));
  await assert.rejects(app.run(input("Check my selected note.")), { code: "SENSITIVE_DATA" });
  assert.equal(calls, 1);assert.equal(reads, 1);
});
test("provider proposal containing a quoted credential is not returned or reviewed", async () => {
  let reviews = 0;
  const app = createRestrictedApplicationRunner(config(() => final(JSON.stringify({ password: fake })), {
    proposalReview: { readOnly: true, evaluate() { reviews++;return { decision: "accept" }; } },
  }));
  await assert.rejects(app.run(input("Return a status proposal.")), { code: "SENSITIVE_DATA" });assert.equal(reviews, 0);
});
test("read-only proposal review feedback cannot send a quoted credential back to the model", async () => {
  let calls = 0;
  const app = createRestrictedApplicationRunner(config(() => { calls++;return final("Observed."); }, {
    proposalReview: { readOnly: true, evaluate: () => ({ decision: "revise", feedback: JSON.stringify({ password: fake }) }) },
  }));
  await assert.rejects(app.run(input("Return a status proposal.")), { code: "PROPOSAL_REVIEW_INVALID" });assert.equal(calls, 1);
});

for (const native of ["openai", "deepseek"]) for (const mode of ["final", "read"]) test(`${native} native ${mode} credential never becomes a public proposal or read`, async () => {
  let calls = 0, reads = 0;
  const complete = () => {
    calls++;
    const message = mode === "final" ? { role: "assistant", content: JSON.stringify({ reply: JSON.stringify({ password: fake }) }) }
      : { role: "assistant", content: null, tool_calls: [{ id: "read_1", type: "function", function: {
        name: "read_note", arguments: JSON.stringify({ query: JSON.stringify({ password: fake }) }),
      } }] };
    return { choices: [{ finish_reason: mode === "final" ? "stop" : "tool_calls", message }] };
  };
  const provider = native === "deepseek" ? createRestrictedDeepSeekProvider({ model: "deepseek-flash", complete })
    : createRestrictedOpenAIProvider({ model: "offline-fixture", supportsImages: false, complete });
  const app = createRestrictedApplicationRunner({ ...config(() => {}), provider,
    tools: [{ name: "read_note", description: "Read authorized note.", readOnly: true,
      inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 500 } }, required: ["query"], additionalProperties: false },
      outputSchema: schema, execute() { reads++;return { reply: "Observed." }; } }],
  });
  await assert.rejects(app.run(input("Check my selected note.")), error => {
    assert.ok(["PROVIDER_FAILED", "SENSITIVE_DATA"].includes(error.code));assert.ok(!String(error).includes(fake));return true;
  });assert.equal(calls, 1);assert.equal(reads, 0);
});
