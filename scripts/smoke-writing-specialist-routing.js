import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { checkToolUse } from "../src/guardrails.js";
import {
  groundWritingSpecialistArgsFromReadEvidence,
  successfulReadFileEvidencePaths,
} from "../src/agent-runner.js";
import { languageWriterDefaults, runWritingSpecialist } from "../src/writing-specialist.js";

const ENV_KEYS = [
  "AGINTI_WRITING_PROVIDER",
  "AGINTI_WRITING_PROVIDER_EN",
  "AGINTI_WRITING_PROVIDER_ZH",
  "AGINTI_WRITING_MODEL",
  "AGINTI_WRITING_MODEL_EN",
  "AGINTI_WRITING_MODEL_ZH",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_PRO_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_DEFAULT_MODEL",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
];

const originalEnvironment = Object.fromEntries(ENV_KEYS.map((name) => [name, process.env[name]]));
let temporaryWorkspace = "";
const localSession = {
  provider: "localllm",
  model: "localllm-deep",
  apiKey: "local-test-key",
  baseURL: "http://127.0.0.1:8008/v1",
  allowHostedWritingSpecialist: false,
};

function clearWriterEnvironment() {
  for (const name of ENV_KEYS) delete process.env[name];
}

try {
  temporaryWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-writer-grounding-"));
  const sourceText = [
    "The launch is waiting for explicit approval.",
    "Correction: the budget is HKD 2,400, not HKD 4,200.",
    "Do not describe the book as completed; only its outline is verified.",
  ].join("\n");
  await fs.writeFile(path.join(temporaryWorkspace, "chat_history.md"), sourceText, "utf8");
  const readMessages = [
    {
      role: "assistant",
      tool_calls: [{
        id: "read-source",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "chat_history.md" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "read-source",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "chat_history.md",
        content: sourceText.slice(0, 24),
        contentTruncated: true,
      }),
    },
  ];
  assert.deepEqual(successfulReadFileEvidencePaths(readMessages), [
    { path: "chat_history.md", complete: false },
  ]);
  const sourceArgs = {
    writingBrief: "Write the current project report based on chat_history.md.",
    canon: "chat_history.md is the sole source of truth.",
    constraints: "Reconcile every correction.",
  };
  const grounded = await groundWritingSpecialistArgsFromReadEvidence(
    sourceArgs,
    { messages: readMessages, meta: {} },
    { commandCwd: temporaryWorkspace }
  );
  assert.deepEqual(grounded.groundedPaths, ["chat_history.md"]);
  assert.match(grounded.args.writingBrief, /AUTHORITATIVE SOURCE MATERIAL/);
  assert.match(grounded.args.writingBrief, /budget is HKD 2,400, not HKD 4,200/);
  assert.match(grounded.args.constraints, /Do not invent generic project details/);

  const creativeArgs = { writingBrief: "Write a restrained harbor scene at dusk." };
  const creative = await groundWritingSpecialistArgsFromReadEvidence(
    creativeArgs,
    { messages: readMessages, meta: {} },
    { commandCwd: temporaryWorkspace }
  );
  assert.strictEqual(creative.args, creativeArgs, "creative writing inherited unrelated source material");
  assert.deepEqual(creative.groundedPaths, []);

  const mutatedMessages = [
    ...readMessages,
    {
      role: "assistant",
      tool_calls: [{
        id: "mutate-source",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: "chat_history.md", content: "changed" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "mutate-source",
      content: JSON.stringify({ ok: true, toolName: "write_file", path: "chat_history.md" }),
    },
  ];
  assert.deepEqual(
    successfulReadFileEvidencePaths(mutatedMessages),
    [],
    "a source mutation did not invalidate stale read evidence"
  );

  clearWriterEnvironment();
  process.env.OPENAI_API_KEY = "ambient-openai-key";
  process.env.DEEPSEEK_API_KEY = "ambient-deepseek-key";
  process.env.LLM_API_KEY = "ambient-generic-key";
  process.env.LLM_BASE_URL = "https://ambient.invalid/v1";
  process.env.LLM_MODEL = "ambient-hosted-model";

  const englishLocal = languageWriterDefaults(
    { language: "en", writingBrief: "Write a restrained harbor scene." },
    localSession
  );
  assert.equal(englishLocal.provider, "localllm", "English writing escaped an active LocalLLM session");
  assert.equal(englishLocal.model, "localllm-deep", "English writing inherited an ambient hosted model");
  assert.equal(englishLocal.reason, "session-default");

  const chineseLocal = languageWriterDefaults(
    { language: "zh-Hans", writingBrief: "写一段克制的港口场景。" },
    localSession
  );
  assert.equal(chineseLocal.provider, "localllm", "Chinese writing escaped an active LocalLLM session");
  assert.equal(chineseLocal.model, "localllm-deep", "Chinese writing inherited an ambient hosted model");
  assert.equal(chineseLocal.reason, "session-default");

  assert.throws(
    () =>
      languageWriterDefaults(
        { provider: "deepseek", language: "zh-Hans", writingBrief: "写一段场景。" },
        localSession
      ),
    (error) => error?.code === "HOSTED_TOOL_PROVIDER_NOT_ALLOWED",
    "model-supplied DeepSeek writer routing escaped an active LocalLLM session"
  );
  const explicitDeepSeek = languageWriterDefaults(
    { provider: "deepseek", language: "zh-Hans", writingBrief: "写一段场景。" },
    { ...localSession, allowHostedWritingSpecialist: true }
  );
  assert.equal(explicitDeepSeek.provider, "deepseek");
  assert.equal(explicitDeepSeek.model, "deepseek-v4-pro");
  assert.equal(explicitDeepSeek.reason, "request-provider");

  process.env.AGINTI_WRITING_PROVIDER = "openai";
  process.env.OPENAI_DEFAULT_MODEL = "explicit-openai-writer";
  assert.throws(
    () => languageWriterDefaults({ language: "en", writingBrief: "Write a scene." }, localSession),
    (error) => error?.code === "HOSTED_TOOL_PROVIDER_NOT_ALLOWED",
    "writer environment escaped an active LocalLLM session without explicit permission"
  );
  const explicitOpenAI = languageWriterDefaults(
    { language: "en", writingBrief: "Write a scene." },
    { ...localSession, allowHostedWritingSpecialist: true }
  );
  assert.equal(explicitOpenAI.provider, "openai");
  assert.equal(explicitOpenAI.model, "explicit-openai-writer");
  assert.equal(explicitOpenAI.reason, "writer-env");

  delete process.env.AGINTI_WRITING_PROVIDER;
  const hostedSession = languageWriterDefaults(
    { language: "en", writingBrief: "Revise the paragraph." },
    { provider: "deepseek", model: "session-deepseek-writer", apiKey: "session-deepseek-key" }
  );
  assert.equal(hostedSession.provider, "deepseek", "provider-neutral routing did not retain the active provider");
  assert.equal(hostedSession.model, "session-deepseek-writer", "provider-neutral routing did not retain the active model");

  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.AGINTI_WRITING_PROVIDER = "openai";
  assert.throws(
    () =>
      languageWriterDefaults(
        { language: "en", writingBrief: "Write a scene." },
        { ...localSession, allowHostedWritingSpecialist: true }
      ),
    /requires OPENAI_API_KEY; generic LLM_\* credentials are not used/,
    "generic LLM_API_KEY was reinterpreted as an OpenAI writer credential"
  );

  delete process.env.AGINTI_WRITING_PROVIDER;
  process.env.OPENAI_API_KEY = "ambient-openai-key";
  process.env.DEEPSEEK_API_KEY = "ambient-deepseek-key";
  const writerCalls = [];
  const writingClientFactory = (writingConfig) => {
    const call = { ...writingConfig, payload: null };
    writerCalls.push(call);
    return {
      chat: {
        completions: {
          create: async (payload) => {
            call.payload = payload;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      draft: `Stub draft from ${writingConfig.provider}.`,
                      revision_notes: [],
                      continuity_notes: [],
                      format_handoff: {},
                      quality_checks: ["stubbed"],
                      questions: [],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };
  };

  const localDraft = await runWritingSpecialist(
    { language: "en", writingBrief: "Write a local scene." },
    { ...localSession, writingClientFactory }
  );
  assert.equal(localDraft.ok, true, `active LocalLLM writer failed: ${localDraft.error || "unknown"}`);
  assert.equal(writerCalls.length, 1);
  assert.equal(writerCalls[0].provider, "localllm", "ambient hosted credentials changed writer routing");
  assert.match(writerCalls[0].baseURL, /^http:\/\/(?:127\.0\.0\.1|localhost):8008\/v1\/?$/);

  const blockedHostedDraft = await runWritingSpecialist(
    { provider: "openai", language: "en", writingBrief: "Try a hosted writer." },
    { ...localSession, writingClientFactory }
  );
  assert.equal(blockedHostedDraft.ok, false);
  assert.equal(blockedHostedDraft.blocked, true, "unapproved hosted writer did not return a visible policy denial");
  assert.equal(writerCalls.length, 1, "blocked hosted writer still created a provider client");

  const allowedHostedDraft = await runWritingSpecialist(
    { provider: "openai", language: "en", writingBrief: "Use the explicitly approved hosted writer." },
    { ...localSession, allowHostedWritingSpecialist: true, writingClientFactory }
  );
  assert.equal(allowedHostedDraft.ok, true, `explicit hosted writer failed: ${allowedHostedDraft.error || "unknown"}`);
  assert.equal(writerCalls.length, 2);
  assert.equal(writerCalls[1].provider, "openai");
  assert.doesNotMatch(writerCalls[1].model, /^localllm-/i, "hosted writer reused the LocalLLM model name");

  const guardrailDenied = checkToolUse({
    toolName: "writing_specialist",
    args: { provider: "openai", writingBrief: "Try a hosted writer." },
    snapshot: { elements: [] },
    config: localSession,
  });
  assert.equal(guardrailDenied.allowed, false, "guardrails allowed a hosted writer override without permission");
  const guardrailAllowed = checkToolUse({
    toolName: "writing_specialist",
    args: { provider: "openai", writingBrief: "Use the hosted writer." },
    snapshot: { elements: [] },
    config: { ...localSession, allowHostedWritingSpecialist: true },
  });
  assert.equal(guardrailAllowed.allowed, true, "guardrails blocked an explicitly approved writer override");

  const unknown = await runWritingSpecialist(
    { provider: "mystery-cloud", writingBrief: "Write a scene." },
    localSession
  );
  assert.equal(unknown.ok, false, "unknown writer provider did not fail visibly");
  assert.match(unknown.error, /Unknown requested writing specialist provider/);

  console.log("writing specialist routing smoke passed");
} finally {
  if (temporaryWorkspace) await fs.rm(temporaryWorkspace, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
